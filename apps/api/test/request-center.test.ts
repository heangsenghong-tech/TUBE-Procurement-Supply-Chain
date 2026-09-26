import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { approvalRuleInput, purchaseRequestInput, serviceRequestInput } from '@tube/shared';
import * as t from '../src/db/schema';
import * as req from '../src/modules/requests/service';
import * as proc from '../src/modules/procurement/service';
import * as master from '../src/modules/master/service';
import * as reports from '../src/modules/reports/service';
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
const typeId = async (key: string) => (await w.db.query.requestTypes.findFirst({ where: eq(t.requestTypes.key, key) }))!.id;
const chainOf = async (requestId: string) => (await req.getRequest(w.db, w.admin, requestId)).approvals.at(-1)!;
const steps = { hodFinance: [{ approverType: 'hod' as const, actionLabel: 'Reviewed' }, { approverType: 'role' as const, roleKey: 'finance_head', actionLabel: 'Approved' }] };

describe('request types', () => {
  it('seeds the standard Request Center types, and the store user sees only active ones', async () => {
    const types = await master.listRequestTypes(w.db, w.people['kdt.staff']!);
    const keys = types.map((x) => x.key);
    for (const k of ['purchase_request', 'new_item_sample', 'it_procurement', 'supplier_request', 'price_inquiry', 'contract_request', 'maintenance']) {
      expect(keys).toContain(k);
    }
  });

  it('refuses a retired type and a type used with the wrong form', async () => {
    const office = await typeId('office_supplies');
    const row = (await master.listRequestTypes(w.db, w.admin, true)).find((x) => x.id === office)!;
    await master.upsertRequestType(w.db, w.admin, office, { ...row, description: row.description, active: false } as never);
    const line = [{ itemId: await w.item('GEN-023'), qty: 30 }];
    await expect(req.createPurchaseRequest(w.db, w.people['kdt.staff']!, { track: 'store', orgUnitId: w.units.KDT!, requestTypeId: office, lines: line }))
      .rejects.toThrow(/no longer offered/);
    await expect(req.createPurchaseRequest(w.db, w.people['kdt.staff']!, { track: 'store', orgUnitId: w.units.KDT!, requestTypeId: await typeId('maintenance'), lines: line }))
      .rejects.toThrow(/can't be submitted with this form/);
  });

  it('a type\'s key and workflow are frozen once it has requests; only administrators manage types', async () => {
    const pr = await typeId('purchase_request');
    const row = (await master.listRequestTypes(w.db, w.admin, true)).find((x) => x.id === pr)!;
    await req.createPurchaseRequest(w.db, w.people['kdt.staff']!, { track: 'store', orgUnitId: w.units.KDT!, lines: [{ itemId: await w.item('I00017'), qty: 1 }] });
    await expect(master.upsertRequestType(w.db, w.admin, pr, { ...row, handling: 'service' } as never)).rejects.toThrow(/can't change/);
    await expect(master.upsertRequestType(w.db, w.people.buyer!, null, { key: 'x_type', name: 'X', group: 'other', handling: 'service', description: '', sortOrder: 1, active: true }))
      .rejects.toThrow();
  });
});

describe('approval routing by conditions', () => {
  it('a request-type rule wins over the general amount rule', async () => {
    // IT purchases of $300+: Supply Chain Manager checks the spec before Finance and CEO.
    await master.createApprovalRule(w.db, w.admin, {
      documentKind: 'request', name: 'IT $300+', minAmount: 300, maxAmount: null, isPettyCash: false, active: true,
      conditions: { requestTypeKeys: ['it_procurement'] },
      steps: [{ approverType: 'hod', actionLabel: 'Reviewed' }, { approverType: 'role', roleKey: 'supply_chain_manager', actionLabel: 'Spec checked' },
        { approverType: 'role', roleKey: 'finance_head', actionLabel: 'Reviewed' }, { approverType: 'role', roleKey: 'ceo', actionLabel: 'Approved' }]
    });
    const laptop = [{ itemId: await w.item('HQ-001'), qty: 1 }];
    const it = await req.createPurchaseRequest(w.db, w.people['mkt.staff']!, { track: 'hq', orgUnitId: w.units.MKT!, requestTypeId: await typeId('it_procurement'), lines: laptop });
    const plain = await req.createPurchaseRequest(w.db, w.people['mkt.staff']!, { track: 'hq', orgUnitId: w.units.MKT!, lines: laptop });
    expect((await chainOf(it.id)).ruleName).toBe('IT $300+');
    expect((await chainOf(it.id)).steps.map((s) => s.actionLabel)).toContain('Spec checked');
    expect((await chainOf(plain.id)).ruleName).toBe('$300 and above');
  });

  it('store-specific and category rules apply only when every condition matches', async () => {
    // Food orders for KDT between $100 and $300 need only the HOD.
    await master.createApprovalRule(w.db, w.admin, {
      documentKind: 'request', name: 'KDT food up to $300', minAmount: 100, maxAmount: 300, isPettyCash: false, active: true,
      conditions: { orgUnitIds: [w.units.KDT!], categories: ['Food'] },
      steps: [{ approverType: 'hod', actionLabel: 'Approved' }]
    });
    const kdt = w.people['kdt.staff']!;
    const food = await req.createPurchaseRequest(w.db, kdt, { track: 'store', orgUnitId: w.units.KDT!, lines: [{ itemId: await w.item('I00043'), qty: 10 }] });
    expect((await chainOf(food.id)).ruleName).toBe('KDT food up to $300');
    const mixed = await req.createPurchaseRequest(w.db, kdt, { track: 'store', orgUnitId: w.units.KDT!,
      lines: [{ itemId: await w.item('I00043'), qty: 10 }, { itemId: await w.item('GEN-023'), qty: 2 }] });
    expect((await chainOf(mixed.id)).ruleName).toBe('$100 – $299');
    const tk = await req.createPurchaseRequest(w.db, w.people['tk.staff']!, { track: 'store', orgUnitId: w.units.TK!, lines: [{ itemId: await w.item('I00043'), qty: 10 }] });
    expect((await chainOf(tk.id)).ruleName).toBe('$100 – $299');
  });

  it('two rules with the same conditions and overlapping amounts are refused; editing one can\'t create the clash either', async () => {
    await expect(master.createApprovalRule(w.db, w.admin, {
      documentKind: 'request', name: 'Clash', minAmount: 200, maxAmount: 500, isPettyCash: false, active: true,
      conditions: { categories: ['Food'], orgUnitIds: [w.units.KDT!] }, steps: steps.hodFinance
    })).rejects.toThrow(/overlaps "KDT food up to \$300"/);
    const rules = await master.listApprovalRules(w.db);
    const it = rules.find((r) => r.name === 'IT $300+')!;
    await expect(master.updateApprovalRule(w.db, w.admin, it.id, {
      name: it.name, minAmount: 300, maxAmount: null, isPettyCash: false, active: true, conditions: {}, steps: steps.hodFinance
    })).rejects.toThrow(/overlaps "\$300 and above"/);
  });

  it('PO rules can use item categories, Direct/Indirect and urgency — not request-only conditions', async () => {
    await expect(master.createApprovalRule(w.db, w.admin, {
      documentKind: 'po', name: 'Bad', minAmount: 0, maxAmount: null, isPettyCash: false, active: true, conditions: { track: 'store' },
      steps: [{ approverType: 'role', roleKey: 'ceo', actionLabel: 'Approved' }]
    })).rejects.toThrow(/PO rules can only depend/);
    await master.createApprovalRule(w.db, w.admin, {
      documentKind: 'po', name: 'Indirect POs $100–$299', minAmount: 100, maxAmount: 300, isPettyCash: false, active: true,
      conditions: { procurementTypes: ['Indirect'] },
      steps: [{ approverType: 'role', roleKey: 'supply_chain_manager', actionLabel: 'Reviewed' }, { approverType: 'role', roleKey: 'ceo', actionLabel: 'Approved' }]
    });
    const pr = await req.createPurchaseRequest(w.db, w.people['kdt.staff']!, { track: 'store', orgUnitId: w.units.KDT!, lines: [{ itemId: await w.item('GEN-012'), qty: 3 }] });
    for (const who of ['kdt.hod', 'finhead']) await req.actOnRequest(w.db, w.people[who]!, pr.id, approve);
    const g = (await proc.reviewQueue(w.db, w.people.buyer!)).find((x) => x.itemCode === 'GEN-012')!;
    const po = await proc.createDirectPo(w.db, w.people.buyer!, { supplierId: await w.supplier('SUP-0001'),
      lines: [{ itemId: g.itemId, qty: 3, unitPrice: 65, requestLineIds: g.contributors.map((c) => c.lineId) }] });
    const detail = await proc.getPo(w.db, w.people.buyer!, po.id);
    expect(detail.approvals[0]!.ruleName).toBe('Indirect POs $100–$299');
  });

  it('the preview shows who would approve, with real names', async () => {
    const p = await master.previewRouting(w.db, w.admin, { documentKind: 'request', amount: 150, orgUnitId: w.units.KDT!, categories: ['Food'] });
    expect(p.rule.name).toBe('KDT food up to $300');
    expect(p.steps[0]!.approver).toMatch(/kdt\.hod \(HOD, KDT\)/);
    const pc = await master.previewRouting(w.db, w.admin, { documentKind: 'request', amount: 20, orgUnitId: w.units.MKT! });
    expect(pc.rule.isPettyCash).toBe(true);
    expect(pc.steps[0]!.approver).toMatch(/none assigned/);
    await expect(master.previewRouting(w.db, w.people.buyer!, { documentKind: 'request', amount: 10 })).rejects.toThrow();
  });
});

describe('urgent requests', () => {
  it('need a reason, jump the queues, and don\'t apply to petty cash', async () => {
    expect(purchaseRequestInput.safeParse({ track: 'store', orgUnitId: w.units.KDT, isUrgent: true, lines: [{ itemId: await w.item('I00043'), qty: 1 }] }).success).toBe(false);

    const tk = w.people['tk.staff']!;
    const normal = await req.createPurchaseRequest(w.db, tk, { track: 'store', orgUnitId: w.units.TK!, lines: [{ itemId: await w.item('I00046'), qty: 5 }] });
    const urgent = await req.createPurchaseRequest(w.db, tk, { track: 'store', orgUnitId: w.units.TK!, isUrgent: true, urgentReason: 'Machine down, store can\'t serve',
      lines: [{ itemId: await w.item('I00047'), qty: 15 }] });
    expect(urgent.isUrgent).toBe(true);
    const inbox = await req.approvalInbox(w.db, w.people['tk.hod']!);
    const pos = (id: string) => inbox.findIndex((e) => e.documentId === id);
    expect(pos(urgent.id)).toBeLessThan(pos(normal.id));

    const petty = await req.createPurchaseRequest(w.db, tk, { track: 'store', orgUnitId: w.units.TK!, isUrgent: true, urgentReason: 'Out of limes', lines: [{ itemId: await w.item('I00017'), qty: 2 }] });
    expect(petty.isPettyCash).toBe(true);
    expect(petty.isUrgent).toBe(false);

    for (const who of ['tk.hod', 'finhead']) await req.actOnRequest(w.db, w.people[who]!, urgent.id, approve);
    const queue = await proc.reviewQueue(w.db, w.people.buyer!);
    expect(queue[0]!.itemCode).toBe('I00047');
    expect(queue[0]!.urgent).toBe(true);
    const dash = await reports.dashboard(w.db, w.people.buyer!);
    expect(dash.urgentPct30d).toBeGreaterThan(0);
  });

  it('an urgency rule can add or shorten approval steps', async () => {
    await master.createApprovalRule(w.db, w.admin, {
      documentKind: 'request', name: 'Urgent $300+: HOD and CEO', minAmount: 300, maxAmount: null, isPettyCash: false, active: true,
      conditions: { urgent: true },
      steps: [{ approverType: 'hod', actionLabel: 'Reviewed' }, { approverType: 'role', roleKey: 'ceo', actionLabel: 'Approved' }]
    });
    const r = await req.createPurchaseRequest(w.db, w.people['kdt.staff']!, { track: 'store', orgUnitId: w.units.KDT!, isUrgent: true,
      urgentReason: 'Grinder broke', lines: [{ itemId: await w.item('GEN-001'), qty: 1 }] });
    expect((await chainOf(r.id)).ruleName).toBe('Urgent $300+: HOD and CEO');
  });
});

describe('service requests', () => {
  const input = async () => ({ track: 'store' as const, orgUnitId: w.units.KDT!, requestTypeId: await typeId('maintenance'),
    subject: 'Air-con leaking', description: 'The unit above the bar drips onto the counter.' });

  it('HOD acknowledges, then Procurement takes and resolves it — it never touches sourcing', async () => {
    const staff = w.people['kdt.staff']!;
    const sv = await req.createServiceRequest(w.db, staff, await input());
    expect(sv.number).toMatch(/^SV-\d{4}-\d{6}$/);
    const d0 = await req.getRequest(w.db, staff, sv.id);
    expect(d0.approvals[0]!.steps.map((s) => s.actionLabel)).toEqual(['Acknowledged']);
    expect(d0.subject).toBe('Air-con leaking');

    await req.actOnRequest(w.db, w.people['kdt.hod']!, sv.id, approve);
    expect((await req.getRequest(w.db, staff, sv.id)).status).toBe('approved');
    expect((await req.serviceQueue(w.db, w.people.buyer!)).some((x) => x.id === sv.id)).toBe(true);
    expect((await proc.reviewQueue(w.db, w.people.buyer!)).flatMap((g) => g.contributors).some((c) => c.requestId === sv.id)).toBe(false);

    await expect(req.assignServiceRequest(w.db, staff, sv.id)).rejects.toThrow();
    await expect(req.assignServiceRequest(w.db, w.people.buyer!, sv.id, w.people['kdt.hod']!.id)).rejects.toThrow(/someone in Procurement/);
    await expect(req.resolveServiceRequest(w.db, w.people.buyer!, sv.id, 'Done')).rejects.toThrow(/Take the request first/);
    await req.assignServiceRequest(w.db, w.people.buyer!, sv.id);
    const d1 = await req.getRequest(w.db, staff, sv.id);
    expect(d1.status).toBe('in_progress');
    expect(d1.assignee!.name).toBe('buyer');

    await req.resolveServiceRequest(w.db, w.people.buyer!, sv.id, 'Technician from CoolAir visited 26 Sep; drain pipe replaced.');
    const d2 = await req.getRequest(w.db, staff, sv.id);
    expect(d2.status).toBe('completed');
    expect(d2.resolution).toMatch(/drain pipe/);
    expect((await req.serviceQueue(w.db, w.people.buyer!)).some((x) => x.id === sv.id)).toBe(false);
  });

  it('can be sent back for changes and resubmitted', async () => {
    const staff = w.people['kdt.staff']!;
    const sv = await req.createServiceRequest(w.db, staff, await input());
    await req.actOnRequest(w.db, w.people['kdt.hod']!, sv.id, { action: 'request_changes', comment: 'Add a photo link' });
    await req.resubmitServiceRequest(w.db, staff, sv.id, { ...(await input()), referenceUrl: 'https://photos.example.com/aircon' });
    const d = await req.getRequest(w.db, staff, sv.id);
    expect(d.status).toBe('pending_approval');
    expect(d.approvals).toHaveLength(2);
  });

  it('needs a subject and description; never falls back to petty cash if its rule is switched off', async () => {
    expect(serviceRequestInput.safeParse({ ...(await input()), subject: '' }).success).toBe(false);
    const rule = (await master.listApprovalRules(w.db)).find((r) => (r.conditions as { handling?: string }).handling === 'service')!;
    await master.updateApprovalRule(w.db, w.admin, rule.id, {
      name: rule.name, minAmount: 0, maxAmount: null, isPettyCash: false, active: false, conditions: { handling: 'service' },
      steps: [{ approverType: 'hod', actionLabel: 'Acknowledged' }]
    });
    await expect(req.createServiceRequest(w.db, w.people['kdt.staff']!, await input())).rejects.toThrow(/No approval rule/);
    await master.updateApprovalRule(w.db, w.admin, rule.id, {
      name: rule.name, minAmount: 0, maxAmount: null, isPettyCash: false, active: true, conditions: { handling: 'service' },
      steps: [{ approverType: 'hod', actionLabel: 'Acknowledged' }]
    });
  });

  it('validates rule input: a petty cash rule can\'t cover service requests', async () => {
    const parsed = approvalRuleInput.parse({ documentKind: 'request', name: 'x', minAmount: 0, maxAmount: 50, isPettyCash: true, active: true,
      conditions: { handling: 'service' }, steps: [{ approverType: 'hod', actionLabel: 'Ack' }] });
    await expect(master.createApprovalRule(w.db, w.admin, parsed)).rejects.toThrow(/purchases only/);
  });
});
