import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql as dsql } from 'drizzle-orm';
import * as t from '../src/db/schema';
import * as req from '../src/modules/requests/service';
import * as proc from '../src/modules/procurement/service';
import * as reports from '../src/modules/reports/service';
import * as master from '../src/modules/master/service';
import { loadActor } from '../src/core/actor';
import { buildWorld, freshDatabase, type World } from './helpers';

let w: World;
let close: () => Promise<void>;

beforeAll(async () => {
  const { db, sql } = await freshDatabase();
  close = () => sql.end();
  w = await buildWorld(db);
});
afterAll(async () => close());

const approve = { action: 'approve' as const };

async function approvedStorePr(staff: string, hod: string, unit: string, lines: { code: string; qty: number }[]) {
  const pr = await req.createPurchaseRequest(w.db, w.people[staff]!, {
    track: 'store', orgUnitId: w.units[unit]!, lines: await Promise.all(lines.map(async (l) => ({ itemId: await w.item(l.code), qty: l.qty })))
  });
  const detail = await req.getRequest(w.db, w.people.admin ?? w.admin, pr.id);
  for (const step of detail.approvals.at(-1)!.steps) {
    const who = step.approver.includes('HOD') ? hod : step.approver.includes('Operation') ? 'ops.head' : step.approver.includes('Finance') ? 'finhead' : 'ceo';
    await req.actOnRequest(w.db, w.people[who]!, pr.id, approve);
  }
  return pr;
}

describe('master data', () => {
  it('loaded the real Item & Supplier Master with normalised units', async () => {
    const [row] = await w.db.execute<{ n: number }>(dsql`select count(*)::int as n from items`);
    expect(row!.n).toBe(160);
    const bean = await w.db.query.items.findFirst({ where: eq(t.items.code, 'I00043') });
    expect(bean!.uom).toBe('Kg');
    const box = await w.db.query.items.findFirst({ where: eq(t.items.code, 'I00063') });
    expect(box!.uom).toBe('Box'); // was "BOX" in the prototype
  });

  it('numbers documents sequentially per year', async () => {
    const a = await req.createSampleRequest(w.db, w.people['mkt.staff']!, { track: 'hq', orgUnitId: w.units.MKT!, itemName: 'Cup', purpose: 'Test', quantity: 1 });
    const b = await req.createSampleRequest(w.db, w.people['mkt.staff']!, { track: 'hq', orgUnitId: w.units.MKT!, itemName: 'Lid', purpose: 'Test', quantity: 1 });
    expect(a.number).toMatch(/^SR-\d{4}-\d{6}$/);
    expect(Number(b.number.slice(-6))).toBe(Number(a.number.slice(-6)) + 1);
  });
});

describe('approval matrix — enforced by the server', () => {
  it('Track B $300+: Head of Operation → Head of Finance → CEO, and only the right person can act on each step', async () => {
    const staff = w.people['kdt.staff']!;
    const pr = await req.createPurchaseRequest(w.db, staff, { track: 'store', orgUnitId: w.units.KDT!, lines: [{ itemId: await w.item('I00043'), qty: 30 }] });
    const d = await req.getRequest(w.db, staff, pr.id);
    expect(d.approvals[0]!.steps.map((s) => s.actionLabel)).toEqual(['Reviewed', 'Reviewed', 'Approved']);
    expect(d.estimatedTotal).toBeNull(); // requesters never see prices…
    expect(JSON.stringify(d)).not.toMatch(/\$/); // …not even the value band in the rule name

    await expect(req.actOnRequest(w.db, staff, pr.id, approve)).rejects.toThrow(/own request|waiting for/);
    await expect(req.actOnRequest(w.db, w.people.ceo!, pr.id, approve)).rejects.toThrow(/waiting for/);
    await expect(req.actOnRequest(w.db, w.people['kdt.hod']!, pr.id, approve)).rejects.toThrow(/waiting for/); // the store's own HOD only acknowledges petty cash
    await req.actOnRequest(w.db, w.people['ops.head']!, pr.id, approve);
    await expect(req.actOnRequest(w.db, w.people.ceo!, pr.id, approve)).rejects.toThrow(/Head of Finance/);
    await req.actOnRequest(w.db, w.people.finhead!, pr.id, approve);
    await req.actOnRequest(w.db, w.people.ceo!, pr.id, approve);
    const after = await req.getRequest(w.db, staff, pr.id);
    expect(after.status).toBe('approved');
    expect(after.lines.every((l) => l.status === 'open')).toBe(true);
    expect(after.approvals[0]!.steps.map((s) => s.actedBy)).toEqual(['ops.head', 'finhead', 'ceo']);
  });

  it('Track B $100–$299: Head of Operation → Head of Finance only, for every store', async () => {
    for (const [unit, staff] of [['KDT', 'kdt.staff'], ['TK', 'tk.staff']] as const) {
      const pr = await req.createPurchaseRequest(w.db, w.people[staff]!, { track: 'store', orgUnitId: w.units[unit]!, lines: [{ itemId: await w.item('I00043'), qty: 10 }] });
      const d = await req.getRequest(w.db, w.admin, pr.id);
      expect(d.estimatedTotal).toBe(113);
      expect(d.approvals[0]!.ruleName).toBe('Track B — Stores: $100 – $299');
      expect(d.approvals[0]!.steps.map((s) => s.actionLabel)).toEqual(['Reviewed', 'Approved']);
    }
  });

  it('Track A: the department\'s own HOD reviews, then Head of Finance (and the CEO from $300)', async () => {
    const staff = w.people['hr.staff']!;
    const mid = await req.createPurchaseRequest(w.db, staff, { track: 'hq', orgUnitId: w.units.HR!, lines: [{ itemId: await w.item('GEN-038'), qty: 30 }] });
    let d = await req.getRequest(w.db, w.admin, mid.id);
    const band = d.estimatedTotal! >= 300 ? 'Track A — HQ: $300 and above' : 'Track A — HQ: $100 – $299';
    expect(d.approvals[0]!.ruleName).toBe(band);
    await expect(req.actOnRequest(w.db, w.people['ops.head']!, mid.id, approve)).rejects.toThrow(/waiting for/); // Operation only reviews stores
    await req.actOnRequest(w.db, w.people['hr.hod']!, mid.id, approve);
    await req.actOnRequest(w.db, w.people.finhead!, mid.id, approve);
    if (band.includes('300')) await req.actOnRequest(w.db, w.people.ceo!, mid.id, approve);
    d = await req.getRequest(w.db, w.admin, mid.id);
    expect(d.status).toBe('approved');
    expect(d.approvals[0]!.steps[0]!.actedBy).toBe('hr.hod');
  });

  it('two approvers acting at the same moment: exactly one succeeds', async () => {
    const pr = await req.createPurchaseRequest(w.db, w.people['kdt.staff']!, { track: 'store', orgUnitId: w.units.KDT!, lines: [{ itemId: await w.item('I00043'), qty: 10 }] });
    await req.actOnRequest(w.db, w.people['ops.head']!, pr.id, approve);
    // Either Head of Finance (e.g. TE Vengsrean or TAING Pengpheng) can act on the step.
    const finhead2 = (await master.upsertUser(w.db, w.admin, null, { email: 'finhead2@tubecafecambodia.com', name: 'finhead2', orgUnitId: w.units.FIN!, roleKeys: ['finance_head'] })).id;
    const results = await Promise.allSettled([
      req.actOnRequest(w.db, w.people.finhead!, pr.id, approve),
      req.actOnRequest(w.db, (await loadActor(w.db, finhead2))!, pr.id, approve)
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('reject cancels the lines; request changes lets the requester resubmit with a fresh chain', async () => {
    const staff = w.people['kdt.staff']!;
    const pr = await req.createPurchaseRequest(w.db, staff, { track: 'store', orgUnitId: w.units.KDT!, lines: [{ itemId: await w.item('I00043'), qty: 10 }] });
    await expect(req.actOnRequest(w.db, w.people['ops.head']!, pr.id, { action: 'request_changes' } as never)).rejects.toThrow(/reason/);
    await req.actOnRequest(w.db, w.people['ops.head']!, pr.id, { action: 'request_changes', comment: 'Too much — halve it' });
    expect((await req.getRequest(w.db, staff, pr.id)).status).toBe('changes_requested');
    await req.resubmitPurchaseRequest(w.db, staff, pr.id, { track: 'store', orgUnitId: w.units.KDT!, lines: [{ itemId: await w.item('I00043'), qty: 5 }] });
    const d = await req.getRequest(w.db, staff, pr.id);
    expect(d.status).toBe('pending_approval');
    expect(d.isPettyCash).toBe(true); // 5 × $11.30 is now under $100
    expect(d.approvals).toHaveLength(2);

    const pr2 = await req.createPurchaseRequest(w.db, staff, { track: 'store', orgUnitId: w.units.KDT!, lines: [{ itemId: await w.item('I00043'), qty: 10 }] });
    await req.actOnRequest(w.db, w.people['ops.head']!, pr2.id, { action: 'reject', comment: 'Not needed' });
    const r = await req.getRequest(w.db, staff, pr2.id);
    expect(r.status).toBe('rejected');
    expect(r.lines[0]!.status).toBe('cancelled');
  });

  it('a store user can only raise requests for their own store', async () => {
    await expect(req.createPurchaseRequest(w.db, w.people['kdt.staff']!, { track: 'store', orgUnitId: w.units.TK!, lines: [{ itemId: await w.item('I00043'), qty: 1 }] }))
      .rejects.toThrow(/own store/);
  });

  it('a unit with no HOD falls back to the Supply Chain Manager as a recorded override', async () => {
    const mkt = w.people['mkt.staff']!; // Marketing has no HOD in this world
    const pr = await req.createPurchaseRequest(w.db, mkt, { track: 'hq', orgUnitId: w.units.MKT!, lines: [{ itemId: await w.item('GEN-038'), qty: 30 }] });
    await expect(req.actOnRequest(w.db, w.people.buyer!, pr.id, approve)).rejects.toThrow(/none assigned/);
    await req.actOnRequest(w.db, w.people.scm!, pr.id, approve);
    const d = await req.getRequest(w.db, w.admin, pr.id);
    expect(d.approvals[0]!.steps[0]!.override).toBe(true);
  });
});

describe('petty cash (below $100)', () => {
  it('needs only the HOD, lands in Finance\'s register and never reaches Procurement', async () => {
    const staff = w.people['tk.staff']!;
    const pc = await req.createPurchaseRequest(w.db, staff, { track: 'store', orgUnitId: w.units.TK!, lines: [{ itemId: await w.item('I00017'), qty: 10 }] });
    expect(pc.isPettyCash).toBe(true);
    let d = await req.getRequest(w.db, w.admin, pc.id);
    expect(d.approvals[0]!.steps.map((s) => s.actionLabel)).toEqual(['Acknowledged']);
    await expect(req.actOnRequest(w.db, w.people['ops.head']!, pc.id, approve)).rejects.toThrow(/waiting for/); // the store's own manager acknowledges
    await req.actOnRequest(w.db, w.people['tk.hod']!, pc.id, approve);
    d = await req.getRequest(w.db, w.admin, pc.id);
    expect(d.status).toBe('petty_cash_approved');
    expect(d.lines[0]!.status).toBe('petty_cash');

    const queue = await proc.reviewQueue(w.db, w.people.buyer!);
    expect(queue.flatMap((g) => g.contributors).some((c) => c.requestId === pc.id)).toBe(false);
    await expect(proc.createQcs(w.db, w.people.buyer!, { groups: [{ itemId: d.lines[0]!.itemId, qty: 10, requestLineIds: [d.lines[0]!.id] }] }))
      .rejects.toThrow(/no longer waiting/);

    await expect(req.reconcilePettyCash(w.db, w.people.buyer!, pc.id, { receiptReference: 'INV-1' })).rejects.toThrow();
    await req.reconcilePettyCash(w.db, w.people.finance!, pc.id, { receiptReference: 'INV-778', actualAmount: 7.2 });
    d = await req.getRequest(w.db, w.people.finance!, pc.id);
    expect(d.status).toBe('petty_cash_reconciled');
    expect(d.reconciliation!.receiptReference).toBe('INV-778');
  });
});

describe('procurement workflow', () => {
  it('consolidates across stores, compares quotes, and makes one multi-line PO per supplier', async () => {
    await approvedStorePr('kdt.staff', 'kdt.hod', 'KDT', [{ code: 'I00031', qty: 12 }, { code: 'I00018', qty: 12 }, { code: 'NEW-022', qty: 2000 }]);
    // 9 × $12.08 = $108.72 — above petty cash, so it goes to Procurement.
    await approvedStorePr('tk.staff', 'tk.hod', 'TK', [{ code: 'I00031', qty: 9 }]);
    const buyer = w.people.buyer!;
    const queue = await proc.reviewQueue(w.db, buyer);
    const vanilla = queue.find((g) => g.itemCode === 'I00031')!;
    expect(vanilla.totalQty).toBe(21);
    expect(vanilla.contributors.map((c) => c.unitName).sort()).toEqual(['KDT', 'Toul Kork']);

    const lychee = queue.find((g) => g.itemCode === 'I00018')!;
    const qcs = await proc.createQcs(w.db, buyer, { groups: [
      { itemId: vanilla.itemId, qty: 24, requestLineIds: vanilla.contributors.map((c) => c.lineId) }, // adjusted up for stock
      { itemId: lychee.itemId, qty: lychee.totalQty, requestLineIds: lychee.contributors.map((c) => c.lineId) }
    ] });
    let sheet = await proc.getQcs(w.db, buyer, qcs.id);
    expect(sheet.prNumbers).toHaveLength(2);
    // Both syrups come pre-filled with Kofi's price on file; nothing is selected automatically.
    expect(sheet.items.every((i) => i.quotes.length === 1 && !i.quotes[0]!.selected)).toBe(true);
    await expect(proc.generatePosFromQcs(w.db, buyer, qcs.id, {})).rejects.toThrow(/Select a winning quote/);

    for (const i of sheet.items) await proc.selectQuotation(w.db, buyer, i.id, { quotationId: i.quotes[0]!.id });
    const pos = await proc.generatePosFromQcs(w.db, buyer, qcs.id, {});
    expect(pos).toHaveLength(1); // same supplier → one PO with two lines
    const po = await proc.getPo(w.db, buyer, pos[0]!.id);
    expect(po.lines).toHaveLength(2);
    expect(po.qcs!.number).toBe(qcs.number);
    expect(po.prNumbers).toHaveLength(2);
    expect(po.lines.find((l) => l.itemCode === 'I00031')!.allocation.map((a) => a.unitName).sort()).toEqual(['KDT', 'Toul Kork']);
    sheet = await proc.getQcs(w.db, buyer, qcs.id);
    expect(sheet.status).toBe('converted');
  });

  it('PO approval: creator can\'t approve their own PO; $300+ goes Finance → CEO', async () => {
    const buyer = w.people.buyer!;
    const list = await proc.listPos(w.db, buyer);
    const po = list.find((p) => p.status === 'pending_approval')!;
    expect(po.total).toBeGreaterThanOrEqual(300);
    await expect(proc.actOnPo(w.db, buyer, po.id, approve)).rejects.toThrow();
    await expect(proc.actOnPo(w.db, w.people.ceo!, po.id, approve)).rejects.toThrow(/Head of Finance/);
    await proc.actOnPo(w.db, w.people.finhead!, po.id, approve);
    await proc.actOnPo(w.db, w.people.ceo!, po.id, approve);
    expect((await proc.getPo(w.db, buyer, po.id)).status).toBe('approved');
  });

  it('fallback supplier: cancelling a PO reopens the comparison with the other quote one click away', async () => {
    const buyer = w.people.buyer!;
    await approvedStorePr('kdt.staff', 'kdt.hod', 'KDT', [{ code: 'I00024', qty: 30 }]);
    const g = (await proc.reviewQueue(w.db, buyer)).find((x) => x.itemCode === 'I00024')!;
    const qcs = await proc.createQcs(w.db, buyer, { groups: [{ itemId: g.itemId, qty: g.totalQty, requestLineIds: g.contributors.map((c) => c.lineId) }] });
    let sheet = await proc.getQcs(w.db, buyer, qcs.id);
    const itemRow = sheet.items[0]!;
    await proc.upsertQuotation(w.db, buyer, itemRow.id, { supplierId: await w.supplier('SUP-0001'), unitPrice: 12.5, originalPrice: 13 });
    sheet = await proc.getQcs(w.db, buyer, qcs.id);
    const [cheapest, second] = [...sheet.items[0]!.quotes].sort((a, b) => a.unitPrice - b.unitPrice);
    await proc.selectQuotation(w.db, buyer, itemRow.id, { quotationId: cheapest!.id, reason: 'Lowest price' });
    const [po] = await proc.generatePosFromQcs(w.db, buyer, qcs.id, {});

    await proc.cancelPo(w.db, buyer, po!.id, 'Supplier out of stock');
    sheet = await proc.getQcs(w.db, buyer, qcs.id);
    expect(sheet.status).toBe('reopened');
    expect(sheet.items[0]!.quotes.find((q) => q.id === cheapest!.id)!.failedBefore).toBe(true);
    expect(sheet.items[0]!.contributors.every((c) => c.status === 'in_qcs')).toBe(true);
    expect((await proc.getPo(w.db, buyer, po!.id)).status).toBe('cancelled'); // kept, not deleted

    await proc.selectQuotation(w.db, buyer, itemRow.id, { quotationId: second!.id, reason: 'Fallback after stock-out' });
    const [po2] = await proc.generatePosFromQcs(w.db, buyer, qcs.id, {});
    const detail = await proc.getPo(w.db, buyer, po2!.id);
    expect(detail.supplier.code).toBe('SUP-0001');
    expect(detail.lines[0]!.avoidance).toBeCloseTo(0.5 * 30, 4);
    expect(detail.qcs!.number).toBe(qcs.number);
  });

  it('cancelling a direct PO returns its lines to Review & Consolidate (prototype bug fixed)', async () => {
    const buyer = w.people.buyer!;
    const g = (await proc.reviewQueue(w.db, buyer)).find((x) => x.itemCode === 'NEW-022')!;
    const po = await proc.createDirectPo(w.db, buyer, { supplierId: g.supplierPrices[0]!.supplierId,
      lines: [{ itemId: g.itemId, qty: g.totalQty, unitPrice: g.supplierPrices[0]!.unitPrice, requestLineIds: g.contributors.map((c) => c.lineId) }] });
    expect((await proc.reviewQueue(w.db, buyer)).find((x) => x.itemCode === 'NEW-022')).toBeUndefined();
    await proc.cancelPo(w.db, buyer, po.id, 'Wrong supplier');
    expect((await proc.reviewQueue(w.db, buyer)).find((x) => x.itemCode === 'NEW-022')!.totalQty).toBe(2000);
  });

  it('delivery completes the requests and records savings against the last price paid', async () => {
    const buyer = w.people.buyer!;
    const approvedPo = (await proc.listPos(w.db, buyer)).find((p) => p.status === 'approved')!;
    await proc.deliverPo(w.db, buyer, approvedPo.id);
    const po = await proc.getPo(w.db, buyer, approvedPo.id);
    expect(po.status).toBe('delivered');
    const reqs = await req.listRequests(w.db, w.admin, { kind: 'purchase' });
    const tkPr = reqs.find((r) => r.orgUnitName === 'Toul Kork' && r.status === 'completed');
    expect(tkPr).toBeDefined();
  });
});

describe('who sees what', () => {
  it('store users see only their own requests and never prices or suppliers', async () => {
    const tkStaff = w.people['tk.staff']!;
    const mine = await req.listRequests(w.db, tkStaff);
    expect(mine.every((r) => r.requesterName === 'tk.staff')).toBe(true);
    expect(mine.every((r) => r.estimatedTotal === null)).toBe(true);
    const kdtReq = (await req.listRequests(w.db, w.admin)).find((r) => r.orgUnitName === 'KDT')!;
    await expect(req.getRequest(w.db, tkStaff, kdtReq.id)).rejects.toThrow(/not found/);
    const items = await master.listItems(w.db, tkStaff);
    expect(items[0]).not.toHaveProperty('prices');
    await expect(master.listSuppliers(w.db, tkStaff)).rejects.toThrow();
    await expect(proc.listPos(w.db, tkStaff)).rejects.toThrow();
    await expect(reports.spend(w.db, tkStaff, 'year')).rejects.toThrow();
  });

  it('HODs see their unit\'s requests with values; not other units', async () => {
    const hod = w.people['tk.hod']!;
    const list = await req.listRequests(w.db, hod);
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((r) => r.orgUnitName === 'Toul Kork')).toBe(true);
    expect(list.every((r) => r.estimatedTotal !== null)).toBe(true);
  });

  it('spend by supplier: Procurement, Finance and leadership only', async () => {
    for (const k of ['buyer', 'finance', 'ceo']) {
      const s = await reports.spend(w.db, w.people[k]!, 'year');
      expect(s.bySupplier).not.toBeNull();
      expect(s.storeSpend).toBeGreaterThan(0);
    }
    // A role that can see spend but not suppliers gets totals without the supplier breakdown.
    await w.db.insert(t.roles).values({ key: 'store_ops_viewer', name: 'Ops viewer' });
    await master.setRolePermissions(w.db, w.admin, 'store_ops_viewer', ['request.create', 'spend.view']);
    const u = await master.upsertUser(w.db, w.admin, null, { email: 'ops.viewer@tubecafecambodia.com', name: 'ops', orgUnitId: w.units.OPS!, roleKeys: ['store_ops_viewer'] });
    const s = await reports.spend(w.db, (await loadActor(w.db, u.id))!, 'year');
    expect(s.bySupplier).toBeNull();
  });

  it('exporting sensitive lists needs Export Authorization, separately from viewing', async () => {
    await expect(reports.exportPriceList(w.db, w.people.buyer!)).rejects.toThrow(/Export Authorization/);
    const csv = await reports.exportPriceList(w.db, w.people['buyer.export']!);
    expect(csv).toContain('Arabica Bean');
    await expect(reports.exportQcs(w.db, w.people.finance!)).rejects.toThrow();
  });
});

describe('audit trail', () => {
  it('records actions and cannot be edited or deleted', async () => {
    const [row] = await w.db.execute<{ n: number }>(dsql`select count(*)::int as n from audit_log where action like 'approval.%'`);
    expect(row!.n).toBeGreaterThan(5);
    const cause = async (p: Promise<unknown>) => { try { await p; return 'no error'; } catch (e) { return String((e as { cause?: Error }).cause?.message); } };
    expect(await cause(w.db.execute(dsql`update audit_log set action = 'x'`))).toMatch(/append-only/);
    expect(await cause(w.db.execute(dsql`delete from audit_log`))).toMatch(/append-only/);
  });
});
